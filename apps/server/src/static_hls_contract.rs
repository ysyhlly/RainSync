//! Stage A probes only the configured actual Worker. It never enables capture.
//! Unknown old-process drain remains unknown regardless of probe readiness.
use anyhow::{Result, ensure};
use persistence::static_hls_activation::{READER_VERSION, WorkerContract};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

static PROBES: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

#[derive(Clone, Debug)]
pub struct Observation {
    pub worker: WorkerContract,
    /// Starts before the request; transport delay consumes freshness budget.
    pub checked_at: Instant,
}

/// One bounded read-only Worker request, using the existing shared source key
/// for purpose-separated fresh AEAD authentication. Shared-cache evidence is a
/// fresh random file written here and read by the actual Worker, not a UUID file.
/// No secret key, source URL or cache path is transmitted.
pub async fn probe(app: &super::App, cache: &Path) -> Result<Observation> {
    let owner = app
        .preparations
        .admit()
        .ok_or_else(|| anyhow::anyhow!("static_hls_probe_draining"))?;
    let permit_slot = PROBES
        .try_acquire()
        .map_err(|_| anyhow::anyhow!("static_hls_probe_busy"))?;
    let challenge = Uuid::new_v4();
    let cache = cache.to_path_buf();
    // The cleanup owner is independent of a cancelled/late probe waiter.
    let app = app.clone();
    let slot = std::sync::Arc::new(std::sync::Mutex::new(
        None::<media_core::static_hls_probe::OwnedProbe>,
    ));
    let (send, wait) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let _slot = permit_slot;
        let _owner = owner;
        let completed = slot.clone();
        let result = probe_owned(&app, &cache, challenge, completed).await;
        let cleanup = media_core::child_process::blocking(move || {
            let owned = slot.lock().expect("probe owner slot").take();
            match owned {
                Some(owned) => owned.remove_owned(),
                None => Ok(()),
            }
        })
        .await;
        let cleanup_database = tokio::time::timeout(Duration::from_millis(750), async {
            let mut connection=app.db.acquire().await?;
            connection.close_on_drop();
            sqlx::query("UPDATE static_hls_database_binding SET probe_challenge=NULL,probe_sha256=NULL,probe_until=NULL WHERE singleton AND probe_challenge=$1")
                .bind(challenge).execute(&mut *connection).await?;
            Ok::<_,anyhow::Error>(())
        }).await;
        let result = if !matches!(cleanup_database, Ok(Ok(()))) {
            Err(anyhow::anyhow!("static_hls_probe_cleanup_unknown"))
        } else {
            result
        };
        let result = if matches!(cleanup, Ok(Ok(()))) {
            result
        } else {
            Err(anyhow::anyhow!("static_hls_probe_cleanup_unknown"))
        };
        let _ = send.send(result);
    });
    // A stalled filesystem owner remains registered/counts against the single
    // slot, while the diagnostic waiter returns bounded unknown evidence.
    tokio::time::timeout(Duration::from_secs(4), wait)
        .await
        .map_err(|_| anyhow::anyhow!("static_hls_probe_owner_unknown"))?
        .map_err(|_| anyhow::anyhow!("static_hls_probe_owner_unknown"))?
}

async fn probe_owned(
    app: &super::App,
    cache: &Path,
    challenge: Uuid,
    completed: std::sync::Arc<std::sync::Mutex<Option<media_core::static_hls_probe::OwnedProbe>>>,
) -> Result<Observation> {
    use sha2::{Digest, Sha256};
    let checked_at = Instant::now();
    let database: Uuid = tokio::time::timeout(Duration::from_millis(750), async {
        let mut connection = app.db.acquire().await?;
        connection.close_on_drop();
        let supported: bool = sqlx::query_scalar("SELECT static_hls_reader_supported()")
            .fetch_one(&mut *connection)
            .await?;
        ensure!(supported, "static_hls_reader_required");
        sqlx::query_scalar("SELECT id FROM static_hls_database_binding WHERE singleton")
            .fetch_one(&mut *connection)
            .await
            .map_err(anyhow::Error::from)
    })
    .await??;
    let mut bytes = [0u8; 64];
    for chunk in bytes.as_chunks_mut::<16>().0 {
        chunk.copy_from_slice(Uuid::new_v4().as_bytes());
    }
    let cache = cache.to_path_buf();
    media_core::child_process::blocking(move || {
        let owned = media_core::static_hls_probe::OwnedProbe::create(
            &cache,
            &challenge.to_string(),
            bytes,
        )?;
        let mut completed = completed.lock().expect("probe owner slot");
        *completed = Some(owned);
        completed.as_mut().unwrap().write_nonce()
    })
    .await??;
    let cache_identity = hex::encode(Sha256::digest(bytes));
    tokio::time::timeout(Duration::from_millis(750), async {
        let mut connection=app.db.acquire().await?;
        connection.close_on_drop();
        let binding:Uuid=sqlx::query_scalar("UPDATE static_hls_database_binding SET probe_challenge=$1,probe_sha256=$2,probe_until=clock_timestamp()+interval '6 seconds' WHERE singleton RETURNING id")
            .bind(challenge).bind(&cache_identity).fetch_one(&mut *connection).await?;
        ensure!(binding==database,"static_hls_probe_database_changed");
        Ok::<_,anyhow::Error>(())
    }).await??;
    let issued = SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_millis()
        .min(u128::from(u64::MAX)) as u64;
    let request=app.encrypt(&serde_json::json!({"purpose":"rainsync-static-hls-contract-request-v1","challenge":challenge,"issued_at_ms":issued}))?;
    let base = std::env::var("WORKER_URL").unwrap_or_else(|_| "http://127.0.0.1:8081".into());
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()?;
    let response = client
        .post(format!(
            "{}/media-delivery/static-hls-contract",
            base.trim_end_matches('/')
        ))
        .body(request)
        .send()
        .await?;
    ensure!(
        response.status() == reqwest::StatusCode::OK,
        "static_hls_worker_contract_unavailable"
    );
    // Bound streamed response even when a hostile endpoint omits its length.
    use futures_util::StreamExt;
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        ensure!(
            body.len() + chunk.len() <= 4096,
            "static_hls_worker_contract_bounds"
        );
        body.extend_from_slice(&chunk);
    }
    let response = app.decrypt(std::str::from_utf8(&body)?)?;
    ensure!(
        response["purpose"] == "rainsync-static-hls-contract-response-v1",
        "static_hls_worker_contract_purpose"
    );
    let worker: WorkerContract = serde_json::from_value(response["contract"].clone())?;
    ensure!(
        worker.version == READER_VERSION
            && !worker.instance.is_nil()
            && worker.database == database
            && worker.challenge == challenge
            && worker.cache_identity == cache_identity,
        "static_hls_worker_contract_mismatch"
    );
    ensure!(
        checked_at.elapsed() <= Duration::from_secs(6),
        "static_hls_worker_contract_stale"
    );
    Ok(Observation { worker, checked_at })
}

/// Explicit current-admin diagnostic only. It accepts no caller-supplied URL,
/// does no startup or periodic work, and can never enable admission.
pub async fn endpoint(
    axum::extract::State(app): axum::extract::State<super::App>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> super::Result<impl axum::response::IntoResponse> {
    let before = super::auth(&app, &headers, true).await?;
    super::admin(&before)?;
    if !(body.is_empty() || body.as_ref() == b"{}") {
        return Err(super::err(
            axum::http::StatusCode::BAD_REQUEST,
            "static_hls_probe_no_arguments",
        ));
    }
    let cache = PathBuf::from(std::env::var("CACHE_ROOT").unwrap_or_else(|_| "/cache".into()));
    let observed = probe(&app, &cache).await;
    // The original exact login and current admin/Origin/CSRF authority must
    // still hold after network/filesystem awaits, including on a late response.
    let after = super::auth(&app, &headers, true).await?;
    super::admin(&after)?;
    if after.id != before.id {
        return Err(super::err(
            axum::http::StatusCode::UNAUTHORIZED,
            "session_expired",
        ));
    }
    let compatible = observed.as_ref().is_ok_and(|value| {
        !value.worker.instance.is_nil() && value.checked_at.elapsed() <= Duration::from_secs(6)
    });
    Ok((
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        axum::Json(serde_json::json!({
            "compatible":compatible,"admission":"disabled","drain":"unknown"
        })),
    ))
}
