//! One bounded complete owned200 representation for explicit HTTP transcode.
//! Weak headers never become external identities. All subsequent reads use this
//! original descriptor; custody and budget outlive caller cancellation.
use super::*;
use crate::preview_input::http_delivery;
use anyhow::ensure;
use media_core::advanced_media::OwnedLocalInput;
use std::{
    collections::HashMap,
    io::Write,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tokio::sync::watch;
#[path = "owned_http/finite_hls.rs"]
mod finite_hls;
#[path = "owned_http/probe_owner.rs"]
mod probe_owner;
const MAX_BYTES: u64 = 128 * 1024 * 1024;
const CAPTURE_TIME: Duration = Duration::from_secs(25);
const MAX_PINNED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const PINNED_CAPTURE_TIME: Duration = Duration::from_secs(300);
static CAPTURES: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
#[derive(Clone)]
struct Snapshot {
    input: Arc<OwnedLocalInput>,
    finite_evidence: Option<Value>,
    bytes: u64,
    sha256: String,
    target_sha256: String,
    until: tokio::time::Instant,
    acquisition_until: tokio::time::Instant,
    retired: watch::Receiver<bool>,
}
#[derive(Clone)]
enum State {
    Capturing,
    Ready(Arc<Snapshot>),
    Closed,
}
struct Registry {
    entries: Mutex<HashMap<Uuid, watch::Receiver<State>>>,
    stop: watch::Sender<bool>,
    active: watch::Sender<usize>,
    runtime: Uuid,
}
fn registry() -> &'static Registry {
    static VALUE: OnceLock<Registry> = OnceLock::new();
    VALUE.get_or_init(|| Registry {
        entries: Mutex::new(HashMap::new()),
        stop: watch::channel(false).0,
        active: watch::channel(0).0,
        runtime: Uuid::new_v4(),
    })
}
async fn allowed(app: &App, id: Uuid) -> anyhow::Result<()> {
    let allowed: bool = tokio::time::timeout(
        Duration::from_secs(2),
        sqlx::query_scalar("SELECT owned_http_representation_authority_allowed($1)")
            .bind(id)
            .fetch_one(&app.db),
    )
    .await??;
    ensure!(allowed, "owned_http_authority_lost");
    Ok(())
}
async fn reserve(app: &App, id: Uuid, owner: Uuid, resource: &Value) -> anyhow::Result<bool> {
    let revision = persistence::cache_budget::snapshot(&app.db).await?;
    let root = app.cache.clone();
    let headroom = child_process::blocking(move || cache::reservation_headroom(&root)).await??;
    let mut tx = app.db.begin().await?;
    let current: i64 =
        sqlx::query_scalar("SELECT revision FROM cache_budget WHERE singleton FOR UPDATE")
            .fetch_one(&mut *tx)
            .await?;
    ensure!(current == revision, "owned_http_budget_changed");
    let held: String =
        sqlx::query_scalar("SELECT COALESCE(sum(bytes),0)::text FROM cache_write_reservations")
            .fetch_one(&mut *tx)
            .await?;
    ensure!(
        held.parse::<u128>()? + u128::from(MAX_BYTES) <= u128::from(headroom),
        "owned_http_cache_full"
    );
    let source = resource["source_id"]
        .as_str()
        .and_then(|s| Uuid::parse_str(s).ok())
        .ok_or_else(|| anyhow::anyhow!("owned_http_source_required"))?;
    let target = resource["url"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("owned_http_target_required"))?;
    let inserted=sqlx::query("INSERT INTO owned_http_representations(session_id,owner_id,runtime_id,request_owner_epoch,user_id,room_id,media_id,media_generation,lifecycle_epoch,login_hash,membership_epoch,source_id,source_revision,viewer_id,plan_generation,target_sha256,state,expires_at,finite_hls_version) SELECT p.id,$2,$3,request.owner_epoch,p.user_id,p.room_id,p.media_id,p.generation,p.lifecycle_epoch,p.auth_login_hash,p.auth_membership_epoch,$4,$5,p.viewer_id,p.plan_generation,$6,'capturing',clock_timestamp()+interval '30 minutes',(p.resource->>'http_finite_hls_version')::smallint FROM playback_sessions p JOIN playback_requests request ON request.session_id=p.id AND request.user_id=p.user_id AND request.status='pending' AND request.lease_until>clock_timestamp() WHERE p.id=$1 AND p.resource->'http_owned_response_version'='1'::jsonb AND p.resource->>'owned_http_session_id'=p.id::text AND p.auth_login_hash IS NOT NULL AND NOT p.stopped AND p.expires_at>clock_timestamp() AND playback_origin_allowed(p.user_id,p.room_id,p.auth_login_hash,p.auth_membership_epoch) AND playback_source_allowed(p.media_id,p.resource,p.id) ON CONFLICT(session_id) DO NOTHING")
        .bind(id).bind(owner).bind(registry().runtime).bind(source).bind(resource["source_policy_revision"].as_i64().ok_or_else(||anyhow::anyhow!("owned_http_source_revision_required"))?).bind(hash(target)).execute(&mut *tx).await?.rows_affected()==1;
    if inserted {
        sqlx::query("INSERT INTO cache_write_reservations(job_id,owner_id,attempt,bytes,purpose) VALUES($1,$2,1,134217728,'owned_http_representation')").bind(owner).bind(owner).execute(&mut *tx).await?;
        sqlx::query("UPDATE cache_budget SET revision=revision+1 WHERE singleton")
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(inserted)
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CaptureClass {
    bytes: u64,
    time: Duration,
    pinned: bool,
}
fn capture_class(
    metadata: &http_identity::Metadata,
    large_enabled: bool,
) -> anyhow::Result<CaptureClass> {
    if let Some(bytes) = metadata.size
        && bytes > MAX_BYTES
    {
        ensure!(
            large_enabled
                && bytes <= MAX_PINNED_BYTES
                && metadata
                    .etag
                    .as_deref()
                    .is_some_and(http_identity::strong_etag),
            "owned_http_large_pinned_representation_required"
        );
        return Ok(CaptureClass {
            bytes,
            time: PINNED_CAPTURE_TIME,
            pinned: true,
        });
    }
    ensure!(
        metadata.size.is_none_or(|n| n > 0 && n <= MAX_BYTES),
        "owned_http_bytes_bound"
    );
    Ok(CaptureClass {
        bytes: MAX_BYTES,
        time: CAPTURE_TIME,
        pinned: false,
    })
}
async fn reserve_pinned(
    app: &App,
    id: Uuid,
    owner: Uuid,
    metadata: &http_identity::Metadata,
    class: CaptureClass,
) -> anyhow::Result<()> {
    ensure!(
        class.pinned && metadata.size == Some(class.bytes),
        "owned_http_pinned_reservation_invalid"
    );
    let revision = persistence::cache_budget::snapshot(&app.db).await?;
    let root = app.cache.clone();
    let headroom = child_process::blocking(move || cache::reservation_headroom(&root)).await??;
    let mut tx = app.db.begin().await?;
    let current: i64 =
        sqlx::query_scalar("SELECT revision FROM cache_budget WHERE singleton FOR UPDATE")
            .fetch_one(&mut *tx)
            .await?;
    ensure!(current == revision, "owned_http_budget_changed");
    let held: String = sqlx::query_scalar(
        "SELECT COALESCE(sum(bytes),0)::text FROM cache_write_reservations WHERE job_id<>$1",
    )
    .bind(owner)
    .fetch_one(&mut *tx)
    .await?;
    ensure!(
        held.parse::<u128>()? + u128::from(class.bytes) <= u128::from(headroom),
        "owned_http_cache_full"
    );
    let changed=sqlx::query("UPDATE owned_http_representations SET capture_class='strong_known_large_v1',capture_limit=$3,capture_etag=$4 WHERE session_id=$1 AND owner_id=$2 AND runtime_id=$5 AND state='capturing' AND capture_class='complete_small_v1' AND bytes IS NULL AND frozen_spec IS NULL AND owned_http_representation_authority_allowed(session_id)").bind(id).bind(owner).bind(i64::try_from(class.bytes)?).bind(&metadata.etag).bind(registry().runtime).execute(&mut *tx).await?.rows_affected();
    ensure!(changed == 1, "owned_http_original_owner_missing");
    let changed=sqlx::query("UPDATE cache_write_reservations SET bytes=$2 WHERE job_id=$1 AND owner_id=$1 AND attempt=1 AND purpose='owned_http_representation' AND bytes=134217728").bind(owner).bind(i64::try_from(class.bytes)?).execute(&mut *tx).await?.rows_affected();
    ensure!(changed == 1, "owned_http_original_owner_missing");
    sqlx::query("UPDATE cache_budget SET revision=revision+1 WHERE singleton")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
struct Files {
    directory: PathBuf,
    path: PathBuf,
    file: Option<std::fs::File>,
    source_version: Option<String>,
    #[cfg(unix)]
    directory_identity: (u64, u64),
}
impl Files {
    fn create(root: PathBuf, owner: Uuid) -> anyhow::Result<Self> {
        let root = root.canonicalize()?;
        let parent = root.join("owned-http");
        if parent.exists() {
            ensure!(
                !std::fs::symlink_metadata(&parent)?.file_type().is_symlink() && parent.is_dir(),
                "owned_http_directory_invalid"
            );
        } else {
            let mut d = std::fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                d.mode(0o700);
            }
            match d.create(&parent) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e.into()),
            };
        }
        ensure!(
            !std::fs::symlink_metadata(&parent)?.file_type().is_symlink() && parent.is_dir(),
            "owned_http_directory_invalid"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let parent_meta = parent.metadata()?;
            ensure!(
                parent_meta.mode() & 0o077 == 0 && parent_meta.uid() == root.metadata()?.uid(),
                "owned_http_directory_permissions"
            );
        }
        let directory = parent.join(owner.to_string());
        let mut d = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            d.mode(0o700);
        }
        d.create(&directory)?;
        let path = directory.join("source.bin");
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&path).map_err(cache::write_error)?;
        Ok(Self {
            directory: directory.clone(),
            path,
            file: Some(file),
            source_version: None,
            #[cfg(unix)]
            directory_identity: {
                use std::os::unix::fs::MetadataExt;
                let m = directory.metadata()?;
                (m.dev(), m.ino())
            },
        })
    }
    fn remove(mut self) -> anyhow::Result<()> {
        drop(self.file.take());
        ensure!(
            !std::fs::symlink_metadata(&self.directory)?
                .file_type()
                .is_symlink(),
            "owned_http_directory_changed"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let m = self.directory.metadata()?;
            ensure!(
                (m.dev(), m.ino()) == self.directory_identity,
                "owned_http_directory_changed"
            );
        }
        if self.path.exists() {
            ensure!(
                !std::fs::symlink_metadata(&self.path)?
                    .file_type()
                    .is_symlink(),
                "owned_http_file_changed"
            );
            if let Some(version) = &self.source_version {
                ensure!(
                    media_core::file_version::snapshot_file(&std::fs::File::open(&self.path)?)?
                        .version
                        == *version,
                    "owned_http_file_changed"
                );
            }
            std::fs::remove_file(&self.path)?;
        }
        std::fs::remove_dir(&self.directory)?;
        Ok(())
    }
}
type FilesSlot = Arc<Mutex<Option<Files>>>;
struct Acquisition {
    owner: Uuid,
    began: tokio::time::Instant,
    until: tokio::time::Instant,
    retired: watch::Receiver<bool>,
}
fn require_complete_response(
    status: StatusCode,
    has_content_range: bool,
    input_failure: &input_failure::Observation,
) -> anyhow::Result<()> {
    // Capture bypasses the generic source proxy, so preserve its original
    // execution's status classification before rejecting a non-complete body.
    input_failure.status(status);
    ensure!(
        status == StatusCode::OK && !has_content_range,
        "owned_http_complete_response_required"
    );
    Ok(())
}
async fn capture(
    app: &App,
    id: Uuid,
    resource: &Value,
    slot: FilesSlot,
    acquisition: Acquisition,
    input_failure: input_failure::Observation,
) -> anyhow::Result<Snapshot> {
    if resource.get("http_finite_hls_version").is_some() {
        return finite_hls::capture(app, id, resource, slot, acquisition).await;
    }
    let Acquisition {
        owner,
        began,
        until,
        retired,
    } = acquisition;
    allowed(app, id).await?;
    let target = resource["url"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("owned_http_target_required"))?;
    let config = providers::resource_config(resource)?;
    let response = tokio::time::timeout_at(began + CAPTURE_TIME, async {
        providers::source_media_request(&config, target, reqwest::Method::GET, &config.headers)
            .await?
            .header(header::ACCEPT_ENCODING, "identity")
            .send()
            .await
    })
    .await
    .map_err(|_| anyhow::anyhow!("owned_http_capture_deadline"))??;
    require_complete_response(
        response.status(),
        response.headers().contains_key(header::CONTENT_RANGE),
        &input_failure,
    )?;
    let metadata = http_identity::Metadata::read(response.status(), response.headers())?;
    let class = capture_class(
        &metadata,
        resource["http_owned_large_response_version"] == 1,
    )?;
    let acquisition_until = (began + class.time).min(until);
    if class.pinned {
        tokio::time::timeout_at(
            began + CAPTURE_TIME,
            reserve_pinned(app, id, owner, &metadata, class),
        )
        .await
        .map_err(|_| anyhow::anyhow!("owned_http_capture_deadline"))??;
    }
    ensure!(
        tokio::time::Instant::now() < acquisition_until,
        "owned_http_capture_deadline"
    );
    ensure!(
        !response
            .url()
            .path()
            .to_ascii_lowercase()
            .ends_with(".m3u8")
            && !response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|h| h.to_str().ok())
                .is_some_and(|v| v.to_ascii_lowercase().contains("mpegurl")),
        "owned_http_binary_required"
    );
    let mut stream = metric_stream::wrap(
        response.bytes_stream(),
        &app.metrics,
        Layer::UpstreamRead,
        Cache::NotHit,
    );
    let mut bytes = 0u64;
    let mut digest = Sha256::new();
    let mut prefix = Vec::new();
    let mut next_check = tokio::time::Instant::now() + Duration::from_millis(250);
    let mut monitored_bytes = 0u64;
    loop {
        let chunk = tokio::select! {
            biased;
            _=tokio::time::sleep_until(acquisition_until)=>anyhow::bail!("owned_http_capture_deadline"),
            _=tokio::time::sleep_until(next_check)=>{
                allowed(app,id).await?;
                next_check=tokio::time::Instant::now()+Duration::from_millis(250);
                continue;
            },
            chunk=stream.next()=>chunk,
        };
        let Some(chunk) = chunk else {
            break;
        };
        let chunk = chunk?;
        // HTTP transport frames are not complete representations. Keep a
        // bounded frame, then hash/write through <=64KiB application chunks.
        ensure!(chunk.len() <= 32 * 1024 * 1024, "owned_http_frame_bound");
        bytes = bytes
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| anyhow::anyhow!("owned_http_bytes_bound"))?;
        ensure!(
            bytes <= class.bytes
                && tokio::time::Instant::now() < acquisition_until
                && !*retired.borrow(),
            "owned_http_bytes_bound"
        );
        if prefix.len() < http_delivery::SNIFF_BYTES {
            prefix.extend_from_slice(
                &chunk[..chunk.len().min(http_delivery::SNIFF_BYTES - prefix.len())],
            );
        }
        if bytes.saturating_sub(monitored_bytes) >= 8 * 1024 * 1024 {
            let root = app.cache.clone();
            let amount = chunk.len() as u64;
            let headroom = tokio::time::timeout_at(
                acquisition_until,
                child_process::blocking(move || cache::reservation_headroom(&root)),
            )
            .await
            .map_err(|_| anyhow::anyhow!("owned_http_capture_deadline"))???;
            ensure!(headroom >= amount, "owned_http_cache_full");
            monitored_bytes = bytes;
        }
        digest.update(&chunk);
        for part in chunk.chunks(65536) {
            let slot = slot.clone();
            let part = part.to_vec();
            tokio::time::timeout_at(
                acquisition_until,
                child_process::blocking(move || -> anyhow::Result<()> {
                    let mut files = slot.lock().unwrap();
                    files
                        .as_mut()
                        .and_then(|f| f.file.as_mut())
                        .ok_or_else(|| anyhow::anyhow!("owned_http_writer_missing"))?
                        .write_all(&part)
                        .map_err(cache::write_error)?;
                    Ok(())
                }),
            )
            .await
            .map_err(|_| anyhow::anyhow!("owned_http_capture_deadline"))???;
        }
    }
    drop(stream);
    ensure!(
        bytes > 0 && metadata.size.is_none_or(|n| n == bytes),
        "owned_http_truncated"
    );
    ensure!(
        !http_delivery::hls_prefix(&prefix)?,
        "owned_http_binary_required"
    );
    let input = tokio::time::timeout_at(
        acquisition_until,
        child_process::blocking(move || -> anyhow::Result<Arc<OwnedLocalInput>> {
            let mut held = slot.lock().unwrap();
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
        }),
    )
    .await
    .map_err(|_| anyhow::anyhow!("owned_http_capture_deadline"))???;
    allowed(app, id).await?;
    ensure!(
        tokio::time::Instant::now() < until && !*retired.borrow(),
        "owned_http_retired"
    );
    Ok(Snapshot {
        input,
        finite_evidence: None,
        bytes,
        sha256: hex::encode(digest.finalize()),
        target_sha256: hash(target),
        until,
        acquisition_until,
        retired,
    })
}
async fn owner(
    app: App,
    id: Uuid,
    resource: Value,
    sender: watch::Sender<State>,
    input_failure: input_failure::Observation,
) {
    let owner = Uuid::new_v4();
    let root_until = tokio::time::Instant::now() + Duration::from_secs(1800);
    let mut reserved = false;
    let slot: FilesSlot = Default::default();
    let mut ready = None;
    let mut global_stop = registry().stop.subscribe();
    let (retired, retirement) = watch::channel(false);
    let scope = child_process::Scope::new();
    let result=async{
        let _permit=CAPTURES.try_acquire().map_err(|_|anyhow::anyhow!("owned_http_capture_busy"))?;
        reserved=reserve(&app,id,owner,&resource).await?;ensure!(reserved,"owned_http_original_owner_missing");
        let began=tokio::time::Instant::now();
        let io_until=began+if resource["http_owned_large_response_version"]==1 {PINNED_CAPTURE_TIME}else{CAPTURE_TIME};
        let work=async {
            let create=slot.clone();let root=app.cache.clone();
            tokio::time::timeout_at(began+CAPTURE_TIME,child_process::blocking(move||->anyhow::Result<()>{*create.lock().unwrap()=Some(Files::create(root,owner)?);Ok(())})).await.map_err(|_|anyhow::anyhow!("owned_http_capture_deadline"))???;
            capture(&app,id,&resource,slot.clone(),Acquisition{owner,began,until:root_until,retired:retirement.clone()},input_failure.clone()).await
        };
        let captured=scope.run(async{tokio::select!{biased;_=global_stop.changed()=>Err(anyhow::anyhow!("owned_http_shutdown")),v=tokio::time::timeout_at(io_until,work)=>v.map_err(|_|anyhow::anyhow!("owned_http_capture_deadline"))?}}).await;
        if captured.is_err(){retired.send_replace(true);sender.send_replace(State::Closed);}
        // A missed observer deadline is never positive completion of a write.
        // Drain the original IO owner before publication or physical cleanup.
        scope.shutdown().await?;
        let snapshot=captured?;
        let io_until=snapshot.acquisition_until;
        ensure!(tokio::time::Instant::now()<io_until && tokio::time::Instant::now()<root_until && !*global_stop.borrow(),"owned_http_capture_deadline");
        let n=sqlx::query("UPDATE owned_http_representations SET state='ready',bytes=$3,sha256=$4,finite_hls_evidence=$5 WHERE session_id=$1 AND owner_id=$2 AND state='capturing' AND owned_http_representation_authority_allowed(session_id)").bind(id).bind(owner).bind(snapshot.bytes as i64).bind(&snapshot.sha256).bind(&snapshot.finite_evidence).execute(&app.db).await?.rows_affected();
        ensure!(n==1 && tokio::time::Instant::now()<io_until && tokio::time::Instant::now()<root_until && !*global_stop.borrow(),"owned_http_authority_lost");
        let snapshot=Arc::new(snapshot);ready=Some(snapshot.clone());sender.send_replace(State::Ready(snapshot));
        drop(_permit);
        loop{tokio::select!{biased;_=global_stop.changed()=>break,_=tokio::time::sleep_until(root_until)=>break,_=tokio::time::sleep(Duration::from_millis(500))=>{if allowed(&app,id).await.is_err(){break;}}}}
        Ok::<_,anyhow::Error>(())
    }.await;
    let _ = result;
    retired.send_replace(true);
    sender.send_replace(State::Closed);
    let drained = scope.shutdown().await.is_ok();
    if reserved {
        let _=sqlx::query("UPDATE owned_http_representations SET state='retired' WHERE session_id=$1 AND owner_id=$2 AND state IN('capturing','ready')").bind(id).bind(owner).execute(&app.db).await;
    }
    if let Some(snapshot) = ready {
        while Arc::strong_count(&snapshot) > 1 || Arc::strong_count(&snapshot.input) > 1 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        drop(snapshot);
    }
    let stream_closed = drained;
    let files = slot.lock().unwrap().take();
    let removed = match files {
        Some(files) if drained => child_process::blocking(move || files.remove())
            .await
            .is_ok_and(|result| result.is_ok()),
        Some(_) => false,
        None => !app
            .cache
            .join("owned-http")
            .join(owner.to_string())
            .exists(),
    };
    if reserved {
        // Retain the original physical proof across transient bookkeeping
        // failures and uncertain COMMIT replies. Only this owner may retry it.
        loop {
            if acknowledge(&app, id, owner, stream_closed, removed)
                .await
                .is_ok()
            {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
    finished(id);
}
async fn acknowledge(
    app: &App,
    id: Uuid,
    owner: Uuid,
    streams: bool,
    removed: bool,
) -> anyhow::Result<()> {
    let mut tx = app.db.begin().await?;
    sqlx::query("SELECT revision FROM cache_budget WHERE singleton FOR UPDATE")
        .execute(&mut *tx)
        .await?;
    let changed=sqlx::query("UPDATE owned_http_representations SET state=$3,streams_closed_at=CASE WHEN $4 THEN COALESCE(streams_closed_at,clock_timestamp()) ELSE NULL END,files_removed_at=CASE WHEN $5 THEN COALESCE(files_removed_at,clock_timestamp()) ELSE NULL END,disposed_at=CASE WHEN $4 AND $5 THEN COALESCE(disposed_at,clock_timestamp()) ELSE NULL END WHERE session_id=$1 AND owner_id=$2 AND runtime_id=$6 AND state IN('capturing','ready','retired','disposed','unknown')").bind(id).bind(owner).bind(if streams&&removed{"disposed"}else{"unknown"}).bind(streams).bind(removed).bind(registry().runtime).execute(&mut *tx).await?.rows_affected();
    ensure!(changed == 1, "owned_http_cleanup_unknown");
    if streams && removed {
        let changed=sqlx::query("DELETE FROM cache_write_reservations WHERE job_id=$1 AND owner_id=$1 AND purpose='owned_http_representation'").bind(owner).execute(&mut *tx).await?.rows_affected();
        if changed > 0 {
            sqlx::query("UPDATE cache_budget SET revision=revision+1 WHERE singleton")
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

fn finished(id: Uuid) {
    let mut entries = registry().entries.lock().unwrap();
    entries.remove(&id);
    registry().active.send_replace(entries.len());
}
async fn acquire(
    app: &App,
    id: Uuid,
    resource: &Value,
    input_failure: input_failure::Observation,
) -> anyhow::Result<Arc<Snapshot>> {
    ensure!(!*registry().stop.borrow(), "owned_http_shutdown");
    let mut receiver = {
        let mut entries = registry().entries.lock().unwrap();
        if let Some(receiver) = entries.get(&id) {
            receiver.clone()
        } else {
            let (sender, receiver) = watch::channel(State::Capturing);
            entries.insert(id, receiver.clone());
            registry().active.send_replace(entries.len());
            tokio::spawn(owner(
                app.clone(),
                id,
                resource.clone(),
                sender,
                input_failure,
            ));
            receiver
        }
    };
    loop {
        let state = receiver.borrow_and_update().clone();
        match state {
            State::Ready(snapshot) => {
                allowed(app, id).await?;
                ensure!(
                    resource["url"]
                        .as_str()
                        .is_some_and(|target| hash(target) == snapshot.target_sha256),
                    "owned_http_target_changed"
                );
                ensure!(
                    tokio::time::Instant::now() < snapshot.until && !*snapshot.retired.borrow(),
                    "owned_http_retired"
                );
                snapshot.input.verify()?;
                return Ok(snapshot);
            }
            State::Closed => anyhow::bail!("owned_http_original_owner_missing"),
            State::Capturing => {
                receiver.changed().await?;
            }
        }
    }
}
pub(crate) fn close() {
    registry().stop.send_replace(true);
}
pub(crate) async fn shutdown() {
    close();
    let mut active = registry().active.subscribe();
    while *active.borrow_and_update() > 0 {
        if active.changed().await.is_err() {
            break;
        }
    }
}

/// Capture finishes before the short-lived decoder starts. Its input is the
/// same retained read-only descriptor used by all later delivery/job reads.
pub(crate) async fn probe_owned(
    app: &App,
    id: Uuid,
    resource: &Value,
    input_failure: input_failure::Observation,
) -> anyhow::Result<Value> {
    ensure!(
        resource["kind"] == "http"
            && resource["http_owned_response_version"] == 1
            && (resource["http_owned_large_response_version"] == 1
                || resource["http_finite_hls_version"] == 1),
        "owned_http_marker_invalid"
    );
    let snapshot = tokio::time::timeout(
        PINNED_CAPTURE_TIME + Duration::from_secs(5),
        acquire(app, id, resource, input_failure),
    )
    .await
    .map_err(|_| anyhow::anyhow!("owned_http_deadline"))??;
    allowed(app, id).await?;
    let retained_app = app.clone();
    let receiver = probe_owner::launch(
        snapshot,
        move |snapshot| async move {
            let mut command = tokio::process::Command::new("ffprobe");
            media_core::input_policy::clean_environment(&mut command);
            command.args(media_core::input_policy::args(false, false));
            command
                .args([
                    "-v",
                    "error",
                    "-max_alloc",
                    "67108864",
                    "-probesize",
                    "8388608",
                    "-analyzeduration",
                    "5000000",
                    "-threads",
                    "1",
                    "-show_format",
                    "-show_streams",
                    "-show_data",
                    "-of",
                    "json",
                    "-i",
                ])
                .arg(snapshot.input.decoder_path()?);
            snapshot.input.install(&mut command)?;
            media_core::bounded_decode::install(&mut command)?;
            let (status, bytes) =
                child_process::capture(command, Duration::from_secs(30), 8 * 1024 * 1024).await?;
            ensure!(status.success(), "owned_http_probe_failed");
            Ok(serde_json::from_slice(&bytes)?)
        },
        move |snapshot, metadata| async move {
            snapshot.input.verify()?;
            allowed(&retained_app, id).await?;
            ensure!(
                tokio::time::Instant::now() < snapshot.until && !*snapshot.retired.borrow(),
                "owned_http_retired"
            );
            Ok(metadata)
        },
    )?;
    receiver
        .await
        .map_err(|_| anyhow::anyhow!("owned_http_probe_owner_missing"))?
}

pub(crate) async fn response(
    app: &App,
    id: Uuid,
    resource: &Value,
    q: &Params,
    h: &HeaderMap,
    head: bool,
) -> Result<Response> {
    if resource["http_owned_response_version"] != 1
        || q.url.is_some()
        || resource["kind"] != "http"
        || resource.get("http_file_root").is_some()
    {
        return Err(failure("owned_http_marker_invalid"));
    }
    let snapshot = tokio::time::timeout(
        if resource["http_owned_large_response_version"] == 1 {
            PINNED_CAPTURE_TIME + Duration::from_secs(5)
        } else {
            Duration::from_secs(30)
        },
        acquire(
            app,
            id,
            resource,
            app.input_failures.observe(id, q.execution),
        ),
    )
    .await
    .map_err(|_| failure("owned_http_deadline"))?
    .map_err(failure)?;
    let mut selected = None;
    let etag = format!("\"owned-sha256-{}\"", snapshot.sha256);
    if !head
        && h.get_all(header::RANGE).iter().count() == 1
        && h.get(header::IF_RANGE).is_none_or(|v| v == etag.as_str())
    {
        match media_core::byte_range(
            h.get(header::RANGE).and_then(|v| v.to_str().ok()),
            snapshot.bytes,
        ) {
            Ok(range) => selected = range,
            Err(error) if error.to_string() == "unsatisfiable_range" => {
                return Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{}", snapshot.bytes))
                    .body(Body::empty())
                    .map_err(failure);
            }
            Err(_) => {}
        }
    }
    let (first, last) = selected.unwrap_or((0, snapshot.bytes - 1));
    let length = last - first + 1;
    let mut response = Response::builder()
        .status(if selected.is_some() {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(
            header::CONTENT_LENGTH,
            if head { snapshot.bytes } else { length },
        )
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ETAG, etag)
        .header(header::CACHE_CONTROL, "private, no-store");
    if selected.is_some() {
        response = response.header(
            header::CONTENT_RANGE,
            format!("bytes {first}-{last}/{}", snapshot.bytes),
        );
    }
    if head {
        return response.body(Body::empty()).map_err(failure);
    }
    let file = snapshot.input.duplicate_file().map_err(failure)?;
    let stream = futures_util::stream::unfold(
        (snapshot, file, first, length),
        |(snapshot, file, offset, left)| async move {
            if left == 0 {
                return None;
            }
            if tokio::time::Instant::now() >= snapshot.until || *snapshot.retired.borrow() {
                return Some((
                    Err(std::io::Error::other("owned_http_retired")),
                    (snapshot, file, offset, 0),
                ));
            }
            let amount = left.min(65536) as usize;
            let held = snapshot.clone();
            let read = child_process::blocking(move || {
                let _held = held;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::FileExt;
                    let mut bytes = vec![0; amount];
                    file.read_exact_at(&mut bytes, offset)?;
                    Ok::<_, std::io::Error>((file, bytes))
                }
                #[cfg(not(unix))]
                {
                    let _ = (file, amount, offset);
                    Err::<(std::fs::File, Vec<u8>), _>(std::io::Error::other(
                        "owned_http_linux_required",
                    ))
                }
            })
            .await;
            match read {
                Ok(Ok((file, bytes))) => Some((
                    Ok::<_, std::io::Error>(bytes),
                    (snapshot, file, offset + amount as u64, left - amount as u64),
                )),
                _ => None,
            }
        },
    );
    response.body(Body::from_stream(stream)).map_err(failure)
}
/// Derive clock repair only from this original runtime's immutable qualified
/// finite capture and the exact currently owned job; UUID/marker alone is not a
/// recipe capability. Ordinary owned HTTP jobs keep their existing argv.
pub(crate) async fn constrain_finite_job(
    app: &App,
    claim: &persistence::media_jobs::Claim,
    args: &mut Vec<String>,
) -> anyhow::Result<()> {
    if claim.spec["kind"] != persistence::owned_http::KIND {
        return Ok(());
    }
    let row=sqlx::query("SELECT h.finite_hls_version,h.finite_hls_evidence,h.runtime_id FROM owned_http_representations h JOIN media_jobs j ON j.session_id=h.session_id WHERE j.id=$1 AND j.owner_id=$2 AND j.attempt=$3 AND j.status='running' AND h.state='ready' AND j.spec=h.frozen_spec AND owned_http_job_allowed(j.id)")
        .bind(claim.id).bind(claim.owner).bind(claim.attempt).fetch_optional(&app.db).await?.ok_or_else(||anyhow::anyhow!("owned_http_original_job_required"))?;
    if row.get::<Option<i16>, _>("finite_hls_version").is_none() {
        return Ok(());
    }
    ensure!(
        row.get::<Uuid, _>("runtime_id") == registry().runtime,
        "finite_hls_original_runtime_required"
    );
    let proof: Value = row.get("finite_hls_evidence");
    let origin = match proof["scope"].as_str() {
        Some("finite_clear_ts_normalization_v1") => 1.0,
        Some("finite_clear_fmp4_normalization_v1") => 0.0,
        _ => anyhow::bail!("finite_hls_physical_proof_required"),
    };
    let duration = proof["manifest_duration_ms"]
        .as_f64()
        .filter(|n| n.is_finite() && *n > 0.0)
        .ok_or_else(|| anyhow::anyhow!("finite_hls_physical_proof_required"))?
        / 1000.0;
    let frame_rate = if origin == 1.0 {
        proof["segments"][0]["video_step_ticks"]
            .as_f64()
            .filter(|s| *s > 0.0)
            .map(|s| 90000.0 / s)
    } else {
        proof["decoded_timeline"]["tracks"]
            .as_array()
            .and_then(|tracks| tracks.iter().find(|t| t["kind"] == "video"))
            .and_then(|t| Some(t["decoded_frames"].as_f64()? / t["end_seconds"].as_f64()?))
            .and_then(|rate| {
                if (rate - 25.0).abs() < 0.00000001 {
                    Some(25.0)
                } else if (rate - 30.0).abs() < 0.00000001 {
                    Some(30.0)
                } else {
                    None
                }
            })
    }
    .filter(|rate| matches!(*rate, 25.0 | 30.0))
    .ok_or_else(|| anyhow::anyhow!("finite_hls_actual_frame_rate_required"))?;
    media_core::finite_hls::constrain_hls_recipe(
        args,
        origin,
        claim.spec["start_seconds"]
            .as_f64()
            .ok_or_else(|| anyhow::anyhow!("finite_hls_recipe_start"))?,
        duration,
        frame_rate,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capture_keeps_execution_scoped_denial_but_requires_complete_200() {
        use persistence::media_jobs::JobFailure;
        let registry = input_failure::Registry::default();
        let id = Uuid::new_v4();
        for (status, expected) in [
            (StatusCode::OK, None),
            (StatusCode::UNAUTHORIZED, Some(JobFailure::InputDenied)),
            (StatusCode::FORBIDDEN, Some(JobFailure::InputDenied)),
            (StatusCode::NOT_FOUND, Some(JobFailure::ExecutionFailed)),
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Some(JobFailure::UpstreamTransient),
            ),
            (StatusCode::PARTIAL_CONTENT, None),
        ] {
            let guard = registry.register(id);
            let next = registry.register(id);
            let observation = registry.observe(id, Some(guard.token()));
            let result = require_complete_response(status, false, &observation);
            assert_eq!(result.is_ok(), status == StatusCode::OK);
            assert_eq!(
                guard.failure().map(JobFailure::reason),
                expected.map(JobFailure::reason)
            );
            assert!(
                next.failure().is_none(),
                "another execution is never poisoned"
            );
            assert!(require_complete_response(StatusCode::OK, true, &observation).is_err());
        }
    }
    #[test]
    fn weak_metadata_never_is_promoted_to_an_external_identity() {
        let mut headers = HeaderMap::new();
        headers.insert(header::ETAG, "W/\"v1\"".parse().unwrap());
        headers.insert(header::CONTENT_LENGTH, "42".parse().unwrap());
        let metadata = http_identity::Metadata::read(StatusCode::OK, &headers).unwrap();
        assert!(!metadata.reliable());
        assert_eq!(MAX_BYTES, 134217728);
        assert_eq!(CAPTURE_TIME.as_secs(), 25);
    }
    #[test]
    fn larger_class_requires_known_length_strong_etag_and_separate_capability() {
        let metadata = |size, etag: Option<&str>| http_identity::Metadata {
            final_target_sha256: None,
            etag: etag.map(str::to_owned),
            modified: None,
            reliable_modified: false,
            size,
        };
        assert_eq!(
            capture_class(&metadata(None, Some("\"v\"")), true)
                .unwrap()
                .bytes,
            MAX_BYTES
        );
        assert!(
            !capture_class(&metadata(Some(42), Some("\"v\"")), true)
                .unwrap()
                .pinned
        );
        let larger = metadata(Some(MAX_BYTES + 1), Some("\"v\""));
        assert!(capture_class(&larger, false).is_err());
        let class = capture_class(&larger, true).unwrap();
        assert!(class.pinned);
        assert_eq!(class.bytes, MAX_BYTES + 1);
        assert_eq!(class.time, PINNED_CAPTURE_TIME);
        assert!(capture_class(&metadata(Some(MAX_BYTES + 1), Some("W/\"v\"")), true).is_err());
        assert!(capture_class(&metadata(Some(MAX_BYTES + 1), None), true).is_err());
        assert!(capture_class(&metadata(Some(MAX_PINNED_BYTES + 1), Some("\"v\"")), true).is_err());
    }
    #[tokio::test]
    async fn a_timed_out_blocking_writer_keeps_original_custody_until_positive_drain() {
        let root =
            std::env::temp_dir().join(format!("rainsync-owned-http-test-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let slot: FilesSlot = Default::default();
        let held = slot.clone();
        let path = root.clone();
        let owner = Uuid::new_v4();
        let scope = child_process::Scope::new();
        let result = scope
            .run(tokio::time::timeout(
                Duration::from_millis(5),
                child_process::blocking(move || {
                    let mut files = Files::create(path, owner).unwrap();
                    files
                        .file
                        .as_mut()
                        .unwrap()
                        .write_all(b"complete synthetic bytes")
                        .unwrap();
                    std::thread::sleep(Duration::from_millis(40));
                    *held.lock().unwrap() = Some(files);
                }),
            ))
            .await;
        assert!(result.is_err());
        scope.shutdown().await.unwrap();
        let files = slot
            .lock()
            .unwrap()
            .take()
            .expect("original late writer custody");
        assert_eq!(
            std::fs::read(&files.path).unwrap(),
            b"complete synthetic bytes"
        );
        files.remove().unwrap();
        std::fs::remove_dir(root.join("owned-http")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
