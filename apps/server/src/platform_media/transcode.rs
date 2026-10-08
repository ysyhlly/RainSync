//! Private finite native input custody and authenticated compatibility output.
//! Signed URLs and accounts never leave the Server's sealed descriptor.
use super::*;
use axum::{
    body::{Body, Bytes},
    extract::Query,
    http::Method,
};
use futures_util::{StreamExt, stream};
use persistence::native_platform_transcode::{self as durable, Spec, Track};
use sqlx::{Postgres, Transaction};

fn ingress_slot() -> Result<tokio::sync::OwnedSemaphorePermit> {
    static SLOTS: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
    SLOTS
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(4)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| {
            err(
                StatusCode::SERVICE_UNAVAILABLE,
                "native_platform_input_busy",
            )
        })
}
use media_core::finite_delivery as owned;
pub(crate) use media_core::finite_delivery::Registry;
pub(crate) struct PreparedSource {
    spec: Spec,
    source_dimensions: Option<(u32, u32)>,
}
fn unsupported() -> Error {
    err(
        StatusCode::UNPROCESSABLE_ENTITY,
        "native_platform_compatibility_source_unsupported",
    )
}
fn invalid() -> Error {
    err(StatusCode::GONE, "invalid_playback_session")
}
/// One original resolver deadline covers all bounded identity observations.
/// No body download or account refresh is performed during admission.
pub(super) async fn prepare_source(
    app: &App,
    sealed: &Sealed,
    expiry_ms: i64,
    deadline: Deadline,
) -> Result<PreparedSource> {
    if expiry_ms > sealed.policy_deadline_ms()?
        || expiry_ms <= unix_ms()?
        || deadline <= Deadline::now()
    {
        return Err(invalid());
    }
    let mut tracks = Vec::new();
    for track in &sealed.descriptor.tracks {
        let mut response = app
            .platform_http
            .media_request_for(
                &sealed.binding.provider,
                &track.url,
                Method::GET,
                Some("bytes=0-0"),
                deadline,
            )
            .await
            .map_err(provider_error)?;
        let facts = representation(response.status(), response.headers(), 0, 0, None)?;
        if track.observed_content_length.is_some_and(|n| n != facts.0)
            || track.strong_etag.as_ref().is_some_and(|e| e != &facts.1)
        {
            return Err(unsupported());
        }
        let mut bytes = 0;
        while let Some(chunk) = tokio::time::timeout_at(deadline, response.next_chunk())
            .await
            .map_err(|_| unsupported())?
            .map_err(|_| unsupported())?
        {
            bytes += chunk.len();
            if bytes > 1 {
                return Err(unsupported());
            }
        }
        if bytes != 1 {
            return Err(unsupported());
        }
        tracks.push(Track {
            container: if track.mime_type == "video/webm" {
                media_core::advanced_media::PrivateInputContainer::Webm
            } else {
                Default::default()
            },
            key: track.key.clone(),
            ticket: token(),
            total_bytes: facts.0,
            strong_etag: facts.1,
        });
    }
    let duration = sealed.descriptor.duration_seconds;
    let source_video = if sealed.descriptor.compatibility_source
        == Some(descriptor::CompatibilitySource::ClearExtendedV1)
    {
        Some(
            sealed.descriptor.tracks[0]
                .source_video
                .clone()
                .ok_or_else(unsupported)?,
        )
    } else {
        None
    };
    let spec = Spec {
        source_webm: sealed.descriptor.tracks[0].source_webm.clone(),
        source_video,
        kind: durable::KIND.into(),
        recipe_version: 1,
        source_kind: "native_platform_private".into(),
        negotiated_mode: "transcode".into(),
        tracks,
        output_ticket: token(),
        duration_seconds: duration,
        start_seconds: 0.0,
        deadline_ms: expiry_ms,
        estimated_output_bytes: ((duration * 850_000.0).ceil() as u64).max(1),
    };
    spec.validate().map_err(|_| unsupported())?;
    Ok(PreparedSource {
        spec,
        source_dimensions: sealed
            .descriptor
            .tracks
            .iter()
            .find_map(|t| Some((t.width?, t.height?))),
    })
}
pub(super) async fn enqueue(
    tx: &mut Transaction<'_, Postgres>,
    session: Uuid,
    prepared: &PreparedSource,
    start_seconds: f64,
    queue_limit: i64,
) -> Result<()> {
    let mut spec = prepared.spec.clone();
    spec.start_seconds = start_seconds;
    spec.estimated_output_bytes =
        (((spec.duration_seconds - start_seconds) * 850_000.0).ceil() as u64).max(1);
    if !durable::enqueue(tx, session, &spec, queue_limit).await? {
        return Err(err(StatusCode::SERVICE_UNAVAILABLE, "media_queue_full"));
    }
    Ok(())
}
/// This planning probe carries geometry only. It is not evidence about the
/// platform codec/color; Worker re-probes the held representations and verifies
/// these exact planned rungs before running the closed recipe.
pub(super) async fn enqueue_ladder(
    tx: &mut Transaction<'_, Postgres>,
    session: Uuid,
    prepared: &PreparedSource,
    start_seconds: f64,
    source_generation: u32,
    plan_generation: u32,
    queue_limit: i64,
) -> Result<()> {
    let (width, height) = prepared.source_dimensions.ok_or_else(unsupported)?;
    let meta = json!({"streams":[{"index":0,"codec_type":"video","codec_name":"h264","width":width,"height":height,"pix_fmt":"yuv420p","sample_aspect_ratio":"1:1","r_frame_rate":"30/1","avg_frame_rate":"30/1","disposition":{"attached_pic":0}},{"index":1,"codec_type":"audio","codec_name":"aac"}]});
    let recipe = media_core::hls_ladder::LadderRecipe::from_probe(&meta, Some(1), start_seconds)
        .map_err(|_| unsupported())?;
    let mut input = prepared.spec.clone();
    input.start_seconds = start_seconds;
    let spec = persistence::native_platform_ladder::job_spec(
        &input,
        source_generation,
        plan_generation,
        &recipe,
    )
    .map_err(|_| unsupported())?;
    if !persistence::native_platform_ladder::enqueue(tx, session, &spec, queue_limit).await? {
        return Err(err(StatusCode::SERVICE_UNAVAILABLE, "media_queue_full"));
    }
    Ok(())
}
/// Only an immutable, decoder-qualified version3 prefix can remove pending.
/// Source expiry is unchanged, including after an output has completed.
pub(crate) async fn refresh_plan(app: &App, plan: &mut Value) -> Result<()> {
    let session = plan["session_id"]
        .as_str()
        .and_then(|v| Uuid::parse_str(v).ok())
        .ok_or_else(invalid)?;
    let row=sqlx::query("SELECT j.spec,j.status,j.error,j.attempt,(j.lease_until>clock_timestamp()) AS leased,o.status AS output_status,o.validation_version,o.ready_segments,o.visible_manifest,o.manifest_sha256 FROM media_jobs j LEFT JOIN media_outputs o ON o.job_id=j.id AND o.attempt=j.attempt AND o.owner_id=j.owner_id WHERE j.id=$1 AND j.logical_queue IN ('native_platform_transcode_v1','native_platform_hls_ladder_v1') AND native_platform_transcode_session_allowed(j.session_id)").bind(session).fetch_optional(&app.db).await?.ok_or_else(invalid)?;
    let status: String = row.get("status");
    if status == "cancelled" {
        return Err(invalid());
    }
    if status == "failed" {
        let e: Option<String> = row.get("error");
        let (s, r) = persistence::media_jobs::terminal_error(e.as_deref());
        return Err(err(StatusCode::from_u16(s).unwrap(), r));
    }
    let value: Value = row.get("spec");
    if value["kind"] == persistence::native_platform_ladder::KIND {
        return refresh_ladder_plan(app, plan, session, &value).await;
    }
    let manifest: Option<String> = row.get("visible_manifest");
    let digest: Option<String> = row.get("manifest_sha256");
    let ready = ((status == "running"
        && row.get::<Option<bool>, _>("leased") == Some(true)
        && row.get::<Option<String>, _>("output_status").as_deref() == Some("writing"))
        || (status == "succeeded"
            && row.get::<Option<String>, _>("output_status").as_deref() == Some("published")))
        && row.get::<Option<i32>, _>("validation_version") == Some(3)
        && row
            .get::<Option<i32>, _>("ready_segments")
            .is_some_and(|n| n > 0)
        && manifest
            .as_ref()
            .is_some_and(|m| digest.as_deref() == Some(hash(m).as_str()));
    if ready {
        let attempt: i64 = row.get("attempt");
        let spec = durable::validate_input_spec(&row.get("spec")).map_err(|_| invalid())?;
        let available = manifest
            .as_ref()
            .and_then(|m| {
                playback_plan::published_duration_ms(
                    m,
                    row.get::<Option<i32>, _>("ready_segments").unwrap_or(0),
                )
            })
            .filter(|n| *n > 0.0)
            .ok_or_else(invalid)?;
        plan["seekable_media_ranges_ms"] = json!([protocol::PlaybackMediaRange::new(
            spec.start_seconds * 1000.0,
            spec.start_seconds * 1000.0 + available
        )
        .ok_or_else(invalid)?]);
        plan["transport"] = json!("hls");
        plan["pending_job_id"] = Value::Null;
        plan["native_platform"]["compatibility"]["output"] = json!({"attempt":attempt,"complete":status=="succeeded","codecs":"avc1.64001F,mp4a.40.2","width":1280,"height":720});
        let url = plan["playback_url"]
            .as_str()
            .ok_or_else(invalid)?
            .split("&attempt=")
            .next()
            .ok_or_else(invalid)?;
        plan["playback_url"] = json!(format!("{url}&attempt={attempt}"));
    } else {
        plan["transport"] = json!("pending_hls");
        plan["pending_job_id"] = json!(session);
        plan["seekable_media_ranges_ms"] = json!([]);
        if let Some(b) = plan["native_platform"]["compatibility"].as_object_mut() {
            b.remove("output");
        }
        if let Some(url) = plan["playback_url"].as_str() {
            plan["playback_url"] = json!(url.split("&attempt=").next().ok_or_else(invalid)?);
        }
    }
    Ok(())
}
async fn refresh_ladder_plan(
    app: &App,
    plan: &mut Value,
    session: Uuid,
    value: &Value,
) -> Result<()> {
    let spec = persistence::native_platform_ladder::validate_spec(value).map_err(|_| invalid())?;
    let ready = persistence::local_hls_ladder::read(&app.db, session).await?;
    let url = plan["playback_url"]
        .as_str()
        .ok_or_else(invalid)?
        .split("&attempt=")
        .next()
        .ok_or_else(invalid)?
        .to_owned();
    if let Some(snapshot) = ready {
        let master =
            media_core::hls_ladder::parse_master(&snapshot.master).map_err(|_| invalid())?;
        let renditions=master.variants.iter().map(|v|json!({"id":v.id.as_str(),"width":v.width,"height":v.height,"bandwidth":v.bandwidth,"codecs":v.codecs})).collect::<Vec<_>>();
        let high = master.variants.last().ok_or_else(invalid)?;
        plan["native_platform"]["compatibility"]["output"] = json!({"attempt":snapshot.attempt,"complete":snapshot.status=="succeeded","codecs":high.codecs,"width":high.width,"height":high.height,"renditions":renditions});
        plan["transport"] = json!("hls");
        plan["pending_job_id"] = Value::Null;
        plan["seekable_media_ranges_ms"] = json!([protocol::PlaybackMediaRange::new(
            spec.input.start_seconds * 1000.0,
            spec.input.start_seconds * 1000.0 + snapshot.duration_us as f64 / 1000.0
        )
        .ok_or_else(invalid)?]);
        plan["playback_url"] = json!(format!("{url}&attempt={}", snapshot.attempt));
    } else {
        plan["transport"] = json!("pending_hls");
        plan["pending_job_id"] = json!(session);
        plan["seekable_media_ranges_ms"] = json!([]);
        if let Some(b) = plan["native_platform"]["compatibility"].as_object_mut() {
            b.remove("output");
        }
        plan["playback_url"] = json!(url);
    }
    Ok(())
}
/// Authenticated readiness does not confuse a native source grant with a ready
/// encoded prefix. It stays bound to the immutable original viewer plan.
pub(crate) async fn read_authenticated(
    app: &App,
    user: Uuid,
    login: &str,
    session: Uuid,
    generation: Option<u32>,
    position: Option<f64>,
) -> Result<Option<protocol::PlaybackReadiness>> {
    let marked:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM playback_sessions WHERE id=$1 AND resource ? 'native_platform_compatibility_version')").bind(session).fetch_one(&app.db).await?;
    if !marked {
        return Ok(None);
    }
    let row=sqlx::query("SELECT p.plan_generation,j.spec,j.status,j.error,(j.lease_until>clock_timestamp()) AS leased,o.status AS output_status,o.visible_manifest,o.manifest_sha256,o.ready_segments,o.validation_version,v.seq FROM playback_sessions p JOIN media_jobs j ON j.id=p.id AND j.session_id=p.id LEFT JOIN media_outputs o ON o.job_id=j.id AND o.attempt=j.attempt AND o.owner_id=j.owner_id LEFT JOIN playback_observations v ON v.session_id=p.id WHERE p.id=$1 AND p.user_id=$2 AND p.auth_login_hash=$3 AND native_platform_transcode_session_allowed(p.id) AND playback_caller_allowed(p.resource,$2,$3)")
        .bind(session).bind(user).bind(login).fetch_optional(&app.db).await?.ok_or_else(invalid)?;
    let current = u32::try_from(row.get::<i64, _>("plan_generation")).map_err(|_| invalid())?;
    if generation.is_some_and(|g| g != current) {
        return Err(err(StatusCode::CONFLICT, "stale_playback_plan"));
    }
    let spec = durable::validate_input_spec(&row.get("spec")).map_err(|_| invalid())?;
    let status: String = row.get("status");
    if status == "failed" {
        let reason: Option<String> = row.get("error");
        let (s, r) = persistence::media_jobs::terminal_error(reason.as_deref());
        return Err(err(StatusCode::from_u16(s).unwrap(), r));
    }
    if status == "cancelled" {
        return Err(invalid());
    }
    let text: Option<String> = row.get("visible_manifest");
    let digest: Option<String> = row.get("manifest_sha256");
    let live_output = (status == "running"
        && row.get::<Option<bool>, _>("leased") == Some(true)
        && row.get::<Option<String>, _>("output_status").as_deref() == Some("writing"))
        || (status == "succeeded"
            && row.get::<Option<String>, _>("output_status").as_deref() == Some("published"));
    let available = if live_output && row.get::<Option<i32>, _>("validation_version") == Some(3) {
        text.as_ref()
            .filter(|m| digest.as_deref() == Some(hash(m).as_str()))
            .and_then(|m| {
                playback_plan::published_duration_ms(
                    m,
                    row.get::<Option<i32>, _>("ready_segments").unwrap_or(0),
                )
            })
            .unwrap_or(0.0)
    } else {
        0.0
    };
    let available =
        if row.get::<Value, _>("spec")["kind"] == persistence::native_platform_ladder::KIND {
            persistence::local_hls_ladder::read(&app.db, session)
                .await?
                .map_or(0.0, |s| s.duration_us as f64 / 1000.0)
        } else {
            available
        };
    let complete = status == "succeeded" && available > 0.0;
    let playable = available > 0.0 && position.is_none_or(|p| p < available);
    Ok(Some(protocol::PlaybackReadiness {
        session_id: session,
        plan_generation: Some(current),
        status: if status == "queued" {
            protocol::PreparationStatus::Queued
        } else if playable {
            protocol::PreparationStatus::Ready
        } else {
            protocol::PreparationStatus::Preparing
        },
        complete,
        available_until_ms: Some(available),
        seekable_media_ranges_ms: Some(if available > 0.0 {
            vec![
                protocol::PlaybackMediaRange::new(
                    spec.start_seconds * 1000.0,
                    spec.start_seconds * 1000.0 + available,
                )
                .ok_or_else(invalid)?,
            ]
        } else {
            vec![]
        }),
        pending_job_id: (!complete).then_some(session),
        observation_version: row.get::<Option<i64>, _>("seq").map(|_| 1),
        observation_seq: row.get::<Option<i64>, _>("seq").map(|s| s as u64),
    }))
}
#[derive(Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct InputQuery {
    pub ticket: String,
    pub owner: Uuid,
    pub attempt: i64,
}
fn representation(
    status: StatusCode,
    h: &HeaderMap,
    start: u64,
    end: u64,
    expected: Option<&Track>,
) -> Result<(u64, String)> {
    for n in [
        header::CONTENT_RANGE,
        header::CONTENT_LENGTH,
        header::ETAG,
        header::CONTENT_ENCODING,
    ] {
        if h.get_all(n).iter().count() > 1 {
            return Err(unsupported());
        }
    }
    if status != StatusCode::PARTIAL_CONTENT
        || h.get(header::CONTENT_ENCODING)
            .is_some_and(|v| v.as_bytes() != b"identity")
    {
        return Err(unsupported());
    }
    let raw = h
        .get(header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(unsupported)?;
    let (bounds, total) = raw
        .strip_prefix("bytes ")
        .and_then(|v| v.split_once('/'))
        .ok_or_else(unsupported)?;
    let (a, b) = bounds.split_once('-').ok_or_else(unsupported)?;
    let parse = |v: &str| {
        (!v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
            .then(|| v.parse::<u64>().ok())
            .flatten()
    };
    let total = parse(total)
        .filter(|n| *n > 0 && *n <= durable::MAX_INPUT_BYTES)
        .ok_or_else(unsupported)?;
    if parse(a) != Some(start)
        || parse(b) != Some(end)
        || end >= total
        || h.get(header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(parse)
            != Some(end - start + 1)
    {
        return Err(unsupported());
    }
    let etag = h
        .get(header::ETAG)
        .and_then(|v| v.to_str().ok())
        .filter(|v| durable::strong_etag_valid(v))
        .ok_or_else(unsupported)?
        .to_owned();
    if expected.is_some_and(|t| t.total_bytes != total || t.strong_etag != etag) {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    Ok((total, etag))
}
async fn owned(app: &App, id: Uuid, q: &InputQuery) -> Result<()> {
    if q.attempt <= 0 || !durable::ticket_valid(&q.ticket) {
        return Err(invalid());
    }
    match tokio::time::timeout(
        Duration::from_secs(2),
        durable::owned(&app.db, id, q.owner, q.attempt),
    )
    .await
    {
        Ok(Ok(true)) => Ok(()),
        Ok(Ok(false)) => Err(invalid()),
        _ => Err(err(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable")),
    }
}
/// Finite buffering is validated before release. Deadline/revocation checks
/// run while the upstream is stalled, as well as before every body chunk.
async fn collect_bounded<S, C, F>(
    source: S,
    expected: usize,
    deadline: Deadline,
    mut check: C,
) -> Result<Vec<u8>>
where
    S: futures_util::Stream<Item = std::result::Result<Bytes, std::io::Error>>,
    C: FnMut() -> F,
    F: std::future::Future<Output = Result<()>>,
{
    if expected == 0 || expected as u64 > durable::MAX_RANGE_BYTES {
        return Err(unsupported());
    }
    tokio::pin!(source);
    let mut bytes = Vec::with_capacity(expected);
    loop {
        let next = tokio::select! {biased;_=tokio::time::sleep_until(deadline)=>return Err(invalid()),next=source.next()=>next,_=tokio::time::sleep(Duration::from_millis(250))=>{tokio::time::timeout_at(deadline,check()).await.map_err(|_|invalid())??;continue}};
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|_| unsupported())?;
        tokio::time::timeout_at(deadline, check())
            .await
            .map_err(|_| invalid())??;
        if bytes.len() + chunk.len() > expected {
            return Err(unsupported());
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.len() != expected {
        return Err(unsupported());
    }
    tokio::time::timeout_at(deadline, check())
        .await
        .map_err(|_| invalid())??;
    Ok(bytes)
}
async fn await_owned<T>(
    app: &App,
    id: Uuid,
    q: &InputQuery,
    deadline: Deadline,
    work: impl std::future::Future<Output = Result<T>>,
) -> Result<T> {
    owned(app, id, q).await?;
    tokio::pin!(work);
    loop {
        tokio::select! {biased;_=tokio::time::sleep_until(deadline)=>return Err(invalid()),result=&mut work=>{let value=result?;owned(app,id,q).await?;return Ok(value)},_=tokio::time::sleep(Duration::from_secs(1))=>owned(app,id,q).await?}
    }
}
fn evidence(row: &sqlx::postgres::PgRow) -> Result<owned::Evidence> {
    let grant: f64 = row.get("grant_remaining");
    let lease: f64 = row.get("lease_remaining");
    if !grant.is_finite() || !lease.is_finite() || grant <= 0.0 || lease <= 0.0 {
        return Err(invalid());
    }
    Ok(owned::Evidence {
        grant_remaining: Duration::try_from_secs_f64(grant).map_err(|_| invalid())?,
        lease_remaining: Duration::try_from_secs_f64(lease).map_err(|_| invalid())?,
    })
}
async fn input_evidence(app: &App, id: Uuid, key: &str, q: &InputQuery) -> Result<owned::Evidence> {
    let row=sqlx::query("SELECT EXTRACT(epoch FROM(LEAST(p.expires_at,to_timestamp(n.deadline_ms::double precision/1000))-clock_timestamp()))::float8 AS grant_remaining,EXTRACT(epoch FROM(LEAST(j.lease_until,p.expires_at,to_timestamp(n.deadline_ms::double precision/1000))-clock_timestamp()))::float8 AS lease_remaining FROM media_jobs j JOIN playback_sessions p ON p.id=j.session_id JOIN native_platform_transcodes n ON n.session_id=p.id WHERE j.id=$1 AND j.owner_id=$2 AND j.attempt=$3 AND j.status='running' AND j.lease_until>clock_timestamp() AND j.logical_queue IN ('native_platform_transcode_v1','native_platform_hls_ladder_v1') AND native_platform_transcode_session_allowed(p.id) AND EXISTS(SELECT 1 FROM jsonb_array_elements(j.spec->'tracks') t WHERE t->>'key'=$4 AND t->>'ticket'=$5)")
        .bind(id).bind(q.owner).bind(q.attempt).bind(key).bind(&q.ticket).fetch_optional(&app.db).await?.ok_or_else(invalid)?;
    evidence(&row)
}
pub(crate) async fn internal_input(
    State(app): State<App>,
    Path((id, key)): Path<(Uuid, String)>,
    Query(q): Query<InputQuery>,
    headers: HeaderMap,
    method: Method,
) -> Result<Response> {
    if q.attempt <= 0
        || !durable::ticket_valid(&q.ticket)
        || !matches!(key.as_str(), "progressive" | "video" | "audio")
        || !matches!(method, Method::GET | Method::HEAD)
    {
        return Err(invalid());
    }
    let registry = app.native_transcode_delivery.clone();
    let checked_app = app.clone();
    let checked_q = q.clone();
    let checked_key = key.clone();
    let check: owned::Checker = Arc::new(move || {
        let app = checked_app.clone();
        let q = checked_q.clone();
        let key = checked_key.clone();
        Box::pin(async move {
            input_evidence(&app, id, &key, &q)
                .await
                .map_err(|_| anyhow::anyhow!("native_platform_delivery_ended"))
        })
    });
    owned::serve(
        registry,
        check,
        move || internal_input_response(State(app), Path((id, key)), Query(q), headers, method),
        Arc::new(|| {
            err(
                StatusCode::SERVICE_UNAVAILABLE,
                "native_platform_delivery_ended",
            )
        }),
    )
    .await
}
async fn internal_input_response(
    State(app): State<App>,
    Path((id, key)): Path<(Uuid, String)>,
    Query(q): Query<InputQuery>,
    headers: HeaderMap,
    method: Method,
) -> Result<Response> {
    if !matches!(method, Method::GET | Method::HEAD) {
        return Err(err(StatusCode::METHOD_NOT_ALLOWED, "invalid_request"));
    }
    owned(&app, id, &q).await?;
    let row=sqlx::query("SELECT j.spec,p.resource,p.media_id,p.room_id,p.user_id,floor(extract(epoch FROM p.expires_at)*1000)::bigint AS expires FROM media_jobs j JOIN playback_sessions p ON p.id=j.session_id WHERE j.id=$1 AND j.logical_queue IN ('native_platform_transcode_v1','native_platform_hls_ladder_v1')").bind(id).fetch_optional(&app.db).await?.ok_or_else(invalid)?;
    let spec = durable::validate_input_spec(&row.get::<Value, _>("spec")).map_err(|_| invalid())?;
    let facts = spec
        .tracks
        .iter()
        .find(|t| t.key == key && hash(&t.ticket) == hash(&q.ticket))
        .ok_or_else(invalid)?;
    let grant = delivery::decode_resource(
        &app,
        row.get("resource"),
        row.get("media_id"),
        row.get("room_id"),
        row.get("user_id"),
        row.get("expires"),
    )?;
    let track = grant
        .sealed
        .descriptor
        .tracks
        .iter()
        .find(|t| t.key == key)
        .ok_or_else(invalid)?;
    if method == Method::HEAD {
        owned(&app, id, &q).await?;
        return Ok((
            [
                (header::CONTENT_LENGTH, facts.total_bytes.to_string()),
                (header::ACCEPT_RANGES, "bytes".into()),
                (header::CONTENT_TYPE, track.mime_type.clone()),
                (header::CACHE_CONTROL, "private, no-store".into()),
            ],
            Body::empty(),
        )
            .into_response());
    }
    let slot = ingress_slot()?;
    if headers.get_all(header::RANGE).iter().count() > 1 {
        return Err(unsupported());
    }
    let (start, end) = durable::bounded_range(
        headers
            .get(header::RANGE)
            .map(|v| v.to_str().map_err(|_| unsupported()))
            .transpose()?,
        facts.total_bytes,
    )
    .map_err(|_| unsupported())?;
    if !tokio::time::timeout(
        Duration::from_secs(2),
        durable::charge(&app.db, id, q.owner, q.attempt, end - start + 1),
    )
    .await
    .map_err(|_| err(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable"))??
    {
        return Err(invalid());
    }
    let remaining = spec
        .deadline_ms
        .checked_sub(unix_ms()?)
        .filter(|n| *n > 0)
        .ok_or_else(invalid)?;
    let deadline = Deadline::now() + Duration::from_millis(remaining as u64);
    let range = format!("bytes={start}-{end}");
    let request_deadline = deadline.min(Deadline::now() + Duration::from_secs(10));
    let upstream = await_owned(&app, id, &q, request_deadline, async {
        app.platform_http
            .media_request_for(
                &grant.sealed.binding.provider,
                &track.url,
                Method::GET,
                Some(&range),
                request_deadline,
            )
            .await
            .map_err(provider_error)
    })
    .await?;
    representation(
        upstream.status(),
        upstream.headers(),
        start,
        end,
        Some(facts),
    )?;
    let source = stream::try_unfold(upstream, |mut upstream| async move {
        match upstream.next_chunk().await {
            Ok(Some(chunk)) => Ok::<_, std::io::Error>(Some((Bytes::from(chunk), upstream))),
            Ok(None) => Ok(None),
            Err(_) => Err(std::io::Error::other("native_platform_input_ended")),
        }
    });
    let data = collect_bounded(source, (end - start + 1) as usize, request_deadline, || {
        owned(&app, id, &q)
    })
    .await?;
    let stream = stream::try_unfold(
        (app.clone(), q.clone(), Bytes::from(data), slot),
        move |(app, q, data, slot)| async move {
            if data.is_empty() {
                return Ok::<_, std::io::Error>(None);
            };
            owned(&app, id, &q)
                .await
                .map_err(|_| std::io::Error::other("native_platform_input_ended"))?;
            let n = data.len().min(64 * 1024);
            Ok(Some((data.slice(..n), (app, q, data.slice(n..), slot))))
        },
    );
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = StatusCode::PARTIAL_CONTENT;
    for (name, value) in [
        (
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{}", facts.total_bytes),
        ),
        (header::CONTENT_LENGTH, (end - start + 1).to_string()),
        (header::ACCEPT_RANGES, "bytes".into()),
        (header::CACHE_CONTROL, "private, no-store".into()),
        (header::CONTENT_TYPE, track.mime_type.clone()),
    ] {
        response
            .headers_mut()
            .insert(name, value.parse().map_err(|_| unsupported())?);
    }
    Ok(response)
}
#[derive(Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OutputQuery {
    token: String,
    attempt: Option<i64>,
}
async fn check_output(
    app: &App,
    authority: &delivery::Authority,
    id: Uuid,
    attempt: i64,
) -> Result<()> {
    delivery::check(app, authority).await?;
    let allowed:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM media_jobs j JOIN media_outputs o ON o.job_id=j.id AND o.attempt=j.attempt AND o.owner_id=j.owner_id WHERE j.id=$1 AND j.attempt=$2 AND native_platform_transcode_session_allowed(j.session_id) AND o.validation_version=CASE WHEN j.logical_queue='native_platform_hls_ladder_v1' THEN 5 ELSE 3 END AND o.ready_segments>0 AND ((j.status='running' AND j.lease_until>clock_timestamp() AND o.status='writing') OR (j.status='succeeded' AND o.status='published')))").bind(id).bind(attempt).fetch_one(&app.db).await?;
    if allowed { Ok(()) } else { Err(invalid()) }
}
async fn output_evidence(
    app: &App,
    id: Uuid,
    q: &OutputQuery,
    login: &str,
) -> Result<owned::Evidence> {
    let attempt = q.attempt.ok_or_else(invalid)?;
    let row=sqlx::query("SELECT EXTRACT(epoch FROM(LEAST(p.expires_at,to_timestamp(n.deadline_ms::double precision/1000))-clock_timestamp()))::float8 AS grant_remaining,EXTRACT(epoch FROM(LEAST(CASE WHEN j.status='succeeded' THEN p.expires_at ELSE j.lease_until END,p.expires_at,to_timestamp(n.deadline_ms::double precision/1000))-clock_timestamp()))::float8 AS lease_remaining FROM playback_sessions p JOIN native_platform_transcodes n ON n.session_id=p.id JOIN media_jobs j ON j.id=p.id AND j.session_id=p.id JOIN media_outputs o ON o.job_id=j.id AND o.attempt=j.attempt AND o.owner_id=j.owner_id WHERE p.id=$1 AND p.delivery_token_hash=$2 AND p.auth_login_hash=$3 AND j.attempt=$4 AND native_platform_transcode_session_allowed(p.id) AND o.validation_version=CASE WHEN j.logical_queue='native_platform_hls_ladder_v1' THEN 5 ELSE 3 END AND o.ready_segments>0 AND ((j.status='running' AND j.lease_until>clock_timestamp() AND o.status='writing') OR (j.status='succeeded' AND o.status='published'))")
        .bind(id).bind(hash(&q.token)).bind(login).bind(attempt).fetch_optional(&app.db).await?.ok_or_else(invalid)?;
    evidence(&row)
}
pub(crate) async fn public_output(
    State(app): State<App>,
    Path((id, path)): Path<(Uuid, String)>,
    Query(q): Query<OutputQuery>,
    headers: HeaderMap,
    method: Method,
) -> Result<Response> {
    if !durable::ticket_valid(&q.token)
        || !q.attempt.is_some_and(|a| a > 0)
        || !valid_output_path(&path)
        || !matches!(method, Method::GET | Method::HEAD)
    {
        return Err(invalid());
    }
    let login = media_authorization::login_hash(&headers)?;
    let registry = app.native_transcode_delivery.clone();
    let checked_app = app.clone();
    let checked_q = q.clone();
    let check: owned::Checker = Arc::new(move || {
        let app = checked_app.clone();
        let q = checked_q.clone();
        let login = login.clone();
        Box::pin(async move {
            output_evidence(&app, id, &q, &login)
                .await
                .map_err(|_| anyhow::anyhow!("native_platform_delivery_ended"))
        })
    });
    owned::serve(
        registry,
        check,
        move || public_output_response(State(app), Path((id, path)), Query(q), headers, method),
        Arc::new(|| {
            err(
                StatusCode::SERVICE_UNAVAILABLE,
                "native_platform_delivery_ended",
            )
        }),
    )
    .await
}
async fn public_output_response(
    State(app): State<App>,
    Path((id, path)): Path<(Uuid, String)>,
    Query(q): Query<OutputQuery>,
    headers: HeaderMap,
    method: Method,
) -> Result<Response> {
    let (authority, _grant) = delivery::admit_compatibility(&app, &headers, id, &q.token).await?;
    if !durable::allowed(&app.db, id).await? {
        return Err(invalid());
    }
    if !valid_output_path(&path) || q.attempt.is_none() || q.attempt.is_some_and(|a| a <= 0) {
        return Err(err(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    let row = sqlx::query(
        "SELECT spec FROM media_jobs WHERE id=$1 AND logical_queue IN ('native_platform_transcode_v1','native_platform_hls_ladder_v1')",
    )
    .bind(id)
    .fetch_one(&app.db)
    .await?;
    let spec = durable::validate_input_spec(&row.get("spec")).map_err(|_| invalid())?;
    let base = std::env::var("WORKER_URL").unwrap_or_else(|_| "http://127.0.0.1:8081".into());
    let url = format!(
        "{}/native-platform-output/{id}/{path}?ticket={}{}",
        base.trim_end_matches('/'),
        spec.output_ticket,
        q.attempt
            .map(|a| format!("&attempt={a}"))
            .unwrap_or_default()
    );
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(anyhow::Error::from)?;
    // HEAD still validates the bounded committed manifest; no source body is opened.
    let mut request = client.request(
        if path.ends_with(".m3u8") {
            Method::GET
        } else {
            method.clone()
        },
        url,
    );
    for name in [header::RANGE, header::IF_RANGE] {
        if let Some(v) = headers.get(&name) {
            request = request.header(name, v);
        }
    }
    let upstream = request.send().await.map_err(anyhow::Error::from)?;
    check_output(&app, &authority, id, q.attempt.ok_or_else(invalid)?).await?;
    if !upstream.status().is_success() {
        return Err(err(
            upstream.status(),
            if upstream.status() == StatusCode::ACCEPTED {
                "media_job_pending"
            } else {
                "media_job_failed"
            },
        ));
    }
    let playlist = path.ends_with(".m3u8");
    let ladder = path == "master.m3u8" || path.contains('/');
    if ladder != (row.get::<Value, _>("spec")["kind"] == persistence::native_platform_ladder::KIND)
    {
        return Err(invalid());
    }
    let content_type = if playlist {
        "application/vnd.apple.mpegurl"
    } else {
        "video/mp4"
    };
    if playlist {
        let mut text = Vec::new();
        let mut stream = upstream.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(anyhow::Error::from)?;
            if text.len() + chunk.len() > 2 * 1024 * 1024 {
                return Err(unsupported());
            }
            text.extend_from_slice(&chunk);
        }
        check_output(&app, &authority, id, q.attempt.ok_or_else(invalid)?).await?;
        let text = String::from_utf8(text).map_err(|_| unsupported())?;
        let text = if ladder {
            rewrite_ladder_manifest(&text, id, &path, &q.token, q.attempt.ok_or_else(invalid)?)?
        } else {
            text.lines().map(|line| {if !line.is_empty() && !line.starts_with('#'){if !valid_output_path(line){return Err(unsupported());}Ok(format!("/api/v1/platform-delivery/{id}/compatibility/{line}?token={}&attempt={}",q.token,q.attempt.ok_or_else(invalid)?))}
            else if line=="#EXT-X-MAP:URI=\"init.mp4\""{Ok(format!("#EXT-X-MAP:URI=\"/api/v1/platform-delivery/{id}/compatibility/init.mp4?token={}&attempt={}\"",q.token,q.attempt.ok_or_else(invalid)?))}else{Ok(line.to_owned())}}).collect::<Result<Vec<_>>>()?.join("\n")+"\n"
        };
        return Ok((
            [
                (header::CONTENT_TYPE, content_type),
                (header::CACHE_CONTROL, "private, no-store"),
            ],
            if method == Method::HEAD {
                String::new()
            } else {
                text
            },
        )
            .into_response());
    }
    let status = upstream.status();
    let h = upstream.headers().clone();
    let app2 = app.clone();
    let attempt = q.attempt.ok_or_else(invalid)?;
    let body = Body::from_stream(stream::try_unfold(
        (upstream.bytes_stream(), authority, app2),
        move |(mut stream, authority, app)| async move {
            check_output(&app, &authority, id, attempt)
                .await
                .map_err(|_| std::io::Error::other("native_platform_output_ended"))?;
            match stream.next().await {
                Some(Ok(bytes)) => {
                    check_output(&app, &authority, id, attempt)
                        .await
                        .map_err(|_| std::io::Error::other("native_platform_output_ended"))?;
                    Ok(Some((bytes, (stream, authority, app))))
                }
                Some(Err(_)) => Err(std::io::Error::other("native_platform_output_ended")),
                None => Ok(None),
            }
        },
    ));
    let mut response = Response::new(body);
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, content_type.parse().unwrap());
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    for name in [
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
    ] {
        if let Some(v) = h.get(&name) {
            response.headers_mut().insert(name, v.clone());
        }
    }
    Ok(response)
}
fn rewrite_ladder_manifest(
    text: &str,
    id: Uuid,
    path: &str,
    token: &str,
    attempt: i64,
) -> Result<String> {
    use media_core::hls_ladder::{Resource, parse_master, parse_media_playlist};
    let resource = Resource::parse(path).map_err(|_| unsupported())?;
    let rung = match resource {
        Resource::Master => {
            parse_master(text).map_err(|_| unsupported())?;
            None
        }
        Resource::Playlist(r) => {
            parse_media_playlist(text).map_err(|_| unsupported())?;
            Some(r)
        }
        _ => return Err(unsupported()),
    };
    let uri = |value: &str| -> Result<String> {
        let relative = if let Some(r) = rung {
            format!("{}/{value}", r.as_str())
        } else {
            value.to_owned()
        };
        Resource::parse(&relative).map_err(|_| unsupported())?;
        Ok(format!(
            "/api/v1/platform-delivery/{id}/compatibility/{relative}?token={token}&attempt={attempt}"
        ))
    };
    text.lines()
        .map(|line| {
            if line == "#EXT-X-MAP:URI=\"init.mp4\"" {
                Ok(format!("#EXT-X-MAP:URI=\"{}\"", uri("init.mp4")?))
            } else if !line.is_empty() && !line.starts_with('#') {
                uri(line)
            } else {
                Ok(line.to_owned())
            }
        })
        .collect::<Result<Vec<_>>>()
        .map(|v| v.join("\n") + "\n")
}
fn valid_output_path(path: &str) -> bool {
    if media_core::hls_ladder::Resource::parse(path).is_ok() {
        return true;
    }
    path == "index.m3u8"
        || path == "init.mp4"
        || path
            .strip_prefix("index")
            .and_then(|v| v.strip_suffix(".m4s"))
            .is_some_and(|n| {
                (!n.is_empty()
                    && !n.starts_with('0')
                    && n.bytes().all(|b| b.is_ascii_digit())
                    && n.parse::<u32>().is_ok())
                    || n == "0"
            })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_are_closed_and_canonical() {
        for p in ["index.m3u8", "init.mp4", "index0.m4s", "index12.m4s"] {
            assert!(valid_output_path(p));
        }
        for p in [
            "../init.mp4",
            "index00.m4s",
            "index0.m4s?url=x",
            "https://host/x",
            "key.bin",
            "index-1.m4s",
            "index+1.m4s",
        ] {
            assert!(!valid_output_path(p));
        }
    }
    #[test]
    fn representation_requires_strong_exact_bounded_identity() {
        let mut h = HeaderMap::new();
        h.insert(header::CONTENT_RANGE, "bytes 0-0/100".parse().unwrap());
        h.insert(header::CONTENT_LENGTH, "1".parse().unwrap());
        h.insert(header::ETAG, "\"stable\"".parse().unwrap());
        assert_eq!(
            representation(StatusCode::PARTIAL_CONTENT, &h, 0, 0, None)
                .unwrap()
                .0,
            100
        );
        assert!(representation(StatusCode::OK, &h, 0, 0, None).is_err());
        h.append(header::ETAG, "\"stable\"".parse().unwrap());
        assert!(representation(StatusCode::PARTIAL_CONTENT, &h, 0, 0, None).is_err());
    }
    #[tokio::test]
    async fn bounded_proxy_rejects_overflow_truncation_revocation_and_expired_wait() {
        let until = Deadline::now() + Duration::from_secs(1);
        let chunks = stream::iter([Ok(Bytes::from_static(b"ab")), Ok(Bytes::from_static(b"cd"))]);
        assert_eq!(
            collect_bounded(chunks, 4, until, || async { Ok(()) })
                .await
                .unwrap(),
            b"abcd"
        );
        assert!(
            collect_bounded(
                stream::iter([Ok(Bytes::from_static(b"abc"))]),
                2,
                until,
                || async { Ok(()) }
            )
            .await
            .is_err()
        );
        assert!(
            collect_bounded(
                stream::iter([Ok(Bytes::from_static(b"a"))]),
                2,
                until,
                || async { Ok(()) }
            )
            .await
            .is_err()
        );
        assert!(
            collect_bounded(
                stream::iter([Ok(Bytes::from_static(b"ab"))]),
                2,
                until,
                || async { Err(invalid()) }
            )
            .await
            .is_err()
        );
        assert!(
            collect_bounded(
                stream::pending(),
                2,
                Deadline::now() + Duration::from_millis(2),
                || async { Ok(()) }
            )
            .await
            .is_err()
        );
    }
}
